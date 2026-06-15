from pydantic import BaseModel, EmailStr

class UserBase(BaseModel):
    email: EmailStr
    display_name: str

class UserCreate(UserBase):
    password: str

class UserResponse(UserBase):
    id: str
    avatar_color: str

    class Config:
        from_attributes = True

class Token(BaseModel):
    user: UserResponse
    token: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str